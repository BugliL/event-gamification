import { NextResponse } from 'next/server'
import { client } from '@/lib/sanity'

const GITHUB_TOKEN = process.env.NEXT_PUBLIC_GITHUB_TOKEN

async function githubFetch(url: string, type: string) {
  console.log(`https://api.github.com${url}`, GITHUB_TOKEN)
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.statusText}`)
  }

  return type === 'memberships' ? response.ok : response.json()
}

export async function POST(request: Request) {
  try {
    const { verificationData, playerEmail, challengeId } = await request.json()

    if (!verificationData || !playerEmail || !challengeId) {
      return NextResponse.json(
        { message: 'Invalid request data' },
        { status: 400 }
      )
    }

    // Fetch player from Sanity
    const player = await client.fetch(`
      *[_type == "user" && 
        role == "player" && 
        email == $playerEmail &&
        !($challengeId in completedChallenges[]._ref)
      ][0]
    `, { playerEmail, challengeId })

    if (!player) {
      return NextResponse.json(
        { message: 'Player not found or challenge already completed' },
        { status: 404 }
      )
    }

    // Verify each requirement, verificationData is an object
    const { type, github_username: githubUsername, organization, repository } = verificationData

    try {
      if (type === 'org_follow') {
        if (!organization) {
          throw new Error('Organization is required for org_follow type')
        }

        // Check if user follows the organization
        const membership = await githubFetch(`/orgs/${organization}/members/${githubUsername}`, 'memberships')

        if (!membership) {
          return NextResponse.json({
            message: `User ${githubUsername} is not following ${organization}`,
            success: false
          })
        }
      }

      if (type === 'repo_star') {
        if (!repository || !repository.includes('/')) {
          throw new Error('Valid repository (owner/repo) is required for repo_star type')
        }

        // Check if user starred the repository
        const starred = await githubFetch(`/user/${githubUsername}/starred/${repository}`, 'starred')

        if (!starred) {
          return NextResponse.json({
            message: `User ${githubUsername} has not starred ${repository}`,
            success: false
          })
        }
      }
    } catch (error) {
      console.error('GitHub API Error:', error)
      return NextResponse.json({
        message: `Failed to verify GitHub action: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false
      }, { status: 500 })
    }

    // All verifications passed, update player's completed challenges
    await client
      .patch(player._id)
      .setIfMissing({ completedChallenges: [] })
      .append('completedChallenges', [{
        _key: crypto.randomUUID(),
        _type: 'reference',
        _ref: challengeId
      }])
      .commit()

    return NextResponse.json({
      message: 'GitHub actions verified successfully',
      success: true
    })

  } catch (error) {
    console.error('Webhook Error:', error)
    return NextResponse.json(
      { message: 'Failed to process webhook', success: false },
      { status: 500 }
    )
  }
} 