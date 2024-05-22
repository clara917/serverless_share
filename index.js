const axios = require('axios');
const { Storage } = require('@google-cloud/storage');
const AWS = require('aws-sdk');
// MailGun
const formData = require('form-data');
const Mailgun = require('mailgun.js');
// Initialize Mailgun
const DOMAIN = 'gecoding.me';
console.log("API Key:", process.env.MAILGUN_API_KEY);
const mailgun = new Mailgun(formData);
const mg = mailgun.client({ username: 'api', key: process.env.MAILGUN_API_KEY });
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');


// Function to check URL accessibility
async function isUrlAccessible(url) {
    try {
        // Check if URL ends with .zip
        if (!url.endsWith('.zip')) {
            console.error(`URL does not end with .zip: ${url}`);
            return false;
        }

        const response = await axios.head(url);
        const contentLength = response.headers['content-length'];
        const contentType = response.headers['content-type'];

        // Check if content type is application/zip and status is 200
        if (response.status === 200 && contentType === 'application/zip') {
            console.log(`URL is accessible and content type is valid: ${url}`);
            return true;
        } else {
            console.error(`URL is accessible but content type is not application/zip: ${url}`);
            return false;
        }
    } catch (error) {
        console.error('URL is not accessible or invalid:', error);
        return false;
    }
}

// Download Release from the GitHub URL
async function downloadFromURL(downloadUrl) {
    if (!await isUrlAccessible(downloadUrl)) {
        throw new Error('URL is not accessible');
    }
    try {
        const response = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream'
        });

        return response.data; // Returns a stream
    } catch (error) {
        console.error('Error downloading release from GitHub URL:', error);
        throw error;
    }
}

// Upload to Google Cloud Storage
async function uploadToGoogleCloudStorage(stream, bucketName, userEmail, submissionCount, assignmentId, storage) {
    const emailPrefix = userEmail.split('@')[0];
    const uniqueFilePath = `${userEmail}/${assignmentId}/submission_${submissionCount}.zip`;
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(uniqueFilePath);

    return new Promise((resolve, reject) => {
        console.log(`Uploading file to GCS: ${bucketName}/${uniqueFilePath}`);

        stream.on('error', error => {
            console.error('Error in input stream:', error);
            reject(error);
        });

        stream.pipe(file.createWriteStream())
            .on('error', error => {
                console.error('Error in write stream:', error);
                reject(error);
            })
            .on('finish', () => {
                console.log(`File uploaded successfully to GCS: ${bucketName}/${uniqueFilePath}`);
                resolve();
            });
    });
}

// Send Email Notification using Mailgun
async function sendEmail(to, subject, body) {
    try {
        const messageData = {
            from: "No Reply <noreply@gecoding.me>",
            to: [to],
            subject: subject,
            text: body,
            html: `<html><body><p>${body}</p></body></html>`
        };

        await mg.messages.create(DOMAIN, messageData);
        console.log(`Email sent to ${to}`);
    } catch (error) {
        console.error(`Error sending email to ${to}:`, error.message);
        throw error;
    }
}


// Record Email in DynamoDB
async function recordEmailStatus(email, status) {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
            id: uuidv4(),
            email: email,
            status: status,
            timestamp: new Date().toISOString()
        }
    };

    return dynamoDB.put(params).promise();
}


// Lambda Handler Function
exports.handler = async (event) => {
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    const { submissionUrl, userEmail, submissionCount, assignmentId } = snsMessage;
    const bucket_name = process.env.GOOGLE_CLOUD_BUCKET;

    try {
        // Decode the private key from an environment variable
        const privateKey = Buffer.from(process.env.GOOGLE_CLOUD_KEY, 'base64').toString('ascii');
        //credential
        const serviceAccountCredentials = JSON.parse(privateKey);
        const storage = new Storage({ credentials: serviceAccountCredentials });

        const stream = await downloadFromURL(submissionUrl);
        await uploadToGoogleCloudStorage(stream, bucket_name, userEmail, submissionCount, assignmentId, storage);

        // const emailBody = `Your file has been downloaded and uploaded successfully. Filename stored in gcs: ${userEmail}/submission_${submissionCount}.zip`;
        const emailBody = `Your file, assignment id: ${assignmentId}, has been downloaded and uploaded successfully.\n` +
            `Filename stored in gcs: ${bucket_name}/${userEmail}/${assignmentId}/submission_${submissionCount}.zip\n` +
            `\nYour submission url: ${submissionUrl}` + 
            `\nYour number of attempts is ${submissionCount}.`;
        await sendEmail(userEmail, 'Download and Upload Successful', emailBody);
        await recordEmailStatus(userEmail, 'Success');
    } catch (error) {
        console.error('Error in processing:', error);
        let failureEmailBody;
        if (error.message.includes('not accessible')) {
            failureEmailBody = `Unfortunately, there was an issue in downloading or uploading your file, assignment id: ${assignmentId}.\n Please check the submitted URL and try again. \n` + 
            `The URL submitted is invalid or the content is empty. Please ensure to submit a valid URL that ends with .zip` + 
            `Your number of attempts is ${submissionCount}.`;
        } else {
            failureEmailBody = `An error occurred during file processing for the file: ${userEmail}/${assignmentId}/submission_${submissionCount}.zip`;
        }

        await sendEmail(userEmail, 'Submission Error', failureEmailBody);

        await recordEmailStatus(userEmail, 'Failure');
        return { status: 'Error', message: error.message };
    }
    return { status: 'Process Complete' };
};